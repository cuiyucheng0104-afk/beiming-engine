"""把逐镜头求解结果（data/solve/*.json）装配成一个主时间轴世界 + 25 台相机。
    python3.14 timeline.py   → data/world_params.json、data/cams.json、终端报告
时间：T = (f-1)/24 + offset[镜头]。参考镜头 S21 偏移 0，卡车车头撞上端柱 t_crash = S21 第 484 帧。
各镜头偏移由事件对齐（见 OFFSET_WHY），这是剪辑时间被拉伸/重叠的实测结果。
科尔维特：各镜头解出的位置换成"相对卡车车头的 dx、横向 y"后按主时间排序成关键帧。
相机：几何镜头用求解位姿（挂世界）；特写镜头按 RIGS 挂在车上，对准目标点。"""
import json
import math

import calib as cb

V = 26.0
T_CRASH = (484 - 1) / cb.FPS
TRUCK_TO_FRONT = 110.0                 # 卡车车头到火车车头（米）：v4 开场复核——车头紧贴一条车厢缝的后面（插在这节车厢前端），缝在车头前约 2.6 m
TRUCK_Y = -2.2                          # v4：车身中心；车头歪着插进车厢侧壁（左前角进车厢约 1.5 m），后部在车厢外
# v4 开场：大货车车头歪着插进客车侧面。tear = 车厢侧壁撕裂口 [相对卡车车头的 X 起, X 止, Z 下, Z 上]（米）
EMBED = {"yaw": 9.0, "pitch": 6.5, "brian_on_cab": [3.0, -0.6, 1.15], "tear": [-10.0, 2.3, 1.45, 3.9]}   # v5：站位挪到驾驶室顶外侧半边；撕裂口上沿 3.9（复核 3.5–4.0）
# v4 开场复核：布莱恩在卡车上的站位按镜头分段（卡车局部坐标，原点车身中心；驾驶室笼架顶局部 z≈1.0）
BRIAN_SHOT_LOCAL = {
    "S01": [[1, 20, [3.3, -1.35, 0.9], "stand"],      # 驾驶室近侧笼架外的踏边上，右手抓横杆、左手扶笼架顶
            [40, 73, [3.0, -0.6, 1.15], "crouch"]],    # 蹲在驾驶室顶外侧半边，半个身子被鼓起的车顶挡住
    "S03": [[95, 135, [4.3, -0.4, 0.6], "crouch"]],    # 车头最前端，正对撕裂口往上爬（v5：在车厢壁外侧）
    "S07": [[207, 236, [2.6, -0.5, 1.9], "stand"]],    # 直立在驾驶室笼架顶（外侧半边）
    "S08": [[237, 254, [3.0, -0.3, 1.0], "crouch"]],   # 从笼架顶往驾驶室里爬
}
CAM_BEHIND_FRONT = {"S11": 7.0, "S13": 8.0}   # 卡车车载相机在车头后多少米（S11 在车斗、布莱恩前方 5 m；S13 贴右后轮）


def tf_offset(f, x_front):
    """已知第 f 帧卡车车头 X，反推该镜头偏移。"""
    return T_CRASH + x_front / V - (f - 1) / cb.FPS


S = {}
for k in cb.SHOTS:
    try:
        S[k] = json.load(open(f"data/solve/{k}.json"))
    except FileNotFoundError:
        pass

OFF, WHY = {}, {}
OFF["S21"], WHY["S21"] = 0.0, "参考：486 帧卡车已顶在端柱上、490 帧起爆，取 484 帧为撞击"
OFF["S22"], WHY["S22"] = 0.0, "S21 的反应镜头，接续"
OFF["S23"], WHY["S23"] = (490 - 585) / cb.FPS, "S23 第 585 帧起爆 = S21 第 490 帧起爆（同一时刻的另一机位）"
OFF["S24"] = OFF["S25"] = OFF["S23"]
OFF["S18"], WHY["S18"] = (484 - 457.7) / cb.FPS, "卡车车载机位在 457.7 帧到达端柱平面 = 撞击"
OFF["S15"], WHY["S15"] = OFF["S18"] + (447 - 409) / cb.FPS, "S18 首帧 447 ≈ S15 的 409 帧（同机位，端柱右缘只多推进 2 帧）"
OFF["S19"] = OFF["S20"] = 0.0
WHY["S19"] = WHY["S20"] = "S20 有端柱锚定：第 475 帧科尔维特 X≈-8、布莱恩刚落车，此时卡车车头约在 -11 → 偏移≈0；S19 与 S20 无缝接续"
OFF["S17"] = OFF["S16"] = (457 - 437) / cb.FPS; WHY["S16"] = WHY["S17"] = "S17 第 437 帧离开车顶 ≈ S19 第 457 帧（S19 首帧已在空中），平行插入"
# 卡车车载机位：相机 X ≈ 卡车车头 X（相机在驾驶室顶）
for k in ("S11", "S13"):
    if k in S:
        c = S[k]["cams"][len(S[k]["cams"]) // 2]
        OFF[k], WHY[k] = tf_offset(c["frame"], c["pose"][0] + CAM_BEHIND_FRONT[k]), f"卡车车载相机 X={c['pose'][0]:.0f}（帧 {c['frame']}），在车头后 {CAM_BEHIND_FRONT[k]} m"
OFF.setdefault("S13", OFF["S15"]); OFF.setdefault("S11", OFF["S15"])
OFF["S12"], WHY["S12"] = OFF["S13"], "布莱恩特写，与 S11–S15 同一段"
OFF["S10"], WHY["S10"] = OFF["S11"], "v3：坐在笼架上（S08 爬出驾驶室之后），与 S11 接续"
OFF["S14"], WHY["S14"] = 2.55, "v3：要在起跳前 0.4 s 结束（原片他还在车顶抬头看）"
# S07：末尾科尔维特追到卡车尾部
if "S07" in S:
    cv = S["S07"]["cv"][-1]
    OFF["S07"], WHY["S07"] = tf_offset(cv["frame"], cv["xyyaw"][0] + cb.TRUCK_LEN), f"第 {cv['frame']} 帧科尔维特追到卡车尾（X={cv['xyyaw'][0]:.0f}）"
OFF["S18"], WHY["S18"] = T_CRASH - (458.7 - 1) / cb.FPS, "驾驶室顶机位在 458.7 帧到达端柱平面 = 撞击（v3：端柱逼近拟合）"
OFF["S15"], WHY["S15"] = OFF["S18"] + 37.2 / cb.FPS, "S15 第 f 帧 = S18 第 f+37.2 帧（v3：同一机位端柱逼近联合拟合）"
if "S09" in S:
    cv = S["S09"]["cv"][-1]
    OFF["S09"], WHY["S09"] = min(5.80, tf_offset(cv["frame"], cv["xyyaw"][0] - 3.0)), "科尔维特在卡车车头前约 3 m；v3：卡车车头不能越过相机（偏移 ≤ 5.80）"
if "S04" in S:                       # 车厢缝定位：卡车驾驶室在 tj4 后约 0.45 节车厢（像素比例），车头约在 tj4 后 8 m
    xf = S["S04"]["c0"] - 3 * (cb.CAR_LEN + cb.CAR_GAP) - 8.0
    OFF["S04"] = tf_offset(cb.SHOTS["S04"][0], xf)
    WHY["S04"] = (f"桥头 + 车厢缝定位：首帧卡车车头 X≈{xf:.0f}。按这个时刻，科尔维特应已追到卡车前，"
                  "画面里却还在卡车后约 26 m → 记为该镜头的科尔维特作弊量")
OFF["S05"] = OFF["S06"] = OFF["S04"]; WHY["S05"] = WHY["S06"] = "插入特写，剪辑上紧接 S04"
def own_truck(k, f):
    s_ = S[k]
    return s_["c0"] + V * (f - cb.SHOTS[k][0]) / cb.FPS + s_["truck"][0] + cb.TRUCK_LEN / 2
for k, f in (("S03", 97), ("S07", 219)):
    if k in S and S[k].get("truck"):
        xf = own_truck(k, f)
        OFF[k], WHY[k] = tf_offset(f, xf), f"本镜头卡车读点：第 {f} 帧卡车车头 X≈{xf:.0f}"
OFF["S07"] -= 0.4; WHY["S07"] += "；v4 开场复核：第 230 帧车头应在 X≈-141.5（模型超前 10 m），提前 0.4 s"
OFF["S08"], WHY["S08"] = OFF["S07"], "接续 S07，同一瞬间换机位"
def _ray_x_on_plane_y(k, f, u, v, Y):
    """镜头 k 第 f 帧的像素 (u, v) 射线和平面 Y=常数 的交点 X（用逐镜头求解的相机）"""
    import numpy as np_
    import cammodel as cm_
    c = min(S[k]["cams"], key=lambda q: abs(q["frame"] - f))["pose"]
    d, rt, up = cm_.basis(c[3], c[4], c[5])
    fpx = (cm_.W / 2) / math.tan(math.radians(S[k]["hfov"]) / 2)
    ray = d + rt * (u - cm_.W / 2) / fpx - up * (v - cm_.H / 2) / fpx
    t_ = (Y - c[1]) / ray[1]
    return c[0] + t_ * ray[0]
# v4 开场复核：S03 第 95 帧驾驶室笼架前沿 (800,250) 回投到车墙面 Y=-1.6，车头约在它前 0.5 m
if "S03" in S:
    xf = _ray_x_on_plane_y("S03", 95, 800, 250, -cb.CAR_W / 2) + 0.5
    OFF["S03"], WHY["S03"] = tf_offset(95, xf), f"v4：第 95 帧驾驶室前沿回投车墙面，卡车车头 X≈{xf:.0f}"
OFF.setdefault("S03", OFF["S04"])
if "S01" in S:            # v4 开场复核：第 3 帧车头紧贴前方那条车厢缝（u≈1040，缝底 v≈330）后约 2.6 m
    xf = _ray_x_on_plane_y("S01", 3, 1040, 330, -cb.CAR_W / 2) - 2.6
    OFF["S01"], WHY["S01"] = tf_offset(3, xf), f"v4：第 3 帧车头前方车厢缝回投车墙面，卡车车头 X≈{xf:.0f}"
OFF.setdefault("S01", OFF["S03"] + (95 - 10) / cb.FPS)
OFF["S02"], WHY["S02"] = OFF["S01"], "接 S01 末（满屏烟尘）"


# 慢镜头流速（世界时间/剪辑时间）：fit_blast.py 用 S21+S23 联合拟合实测（碎片下落必须是 g、两机位科尔维特车速一致）
BLAST = json.load(open("data/blast.json"))
RATE = {"S21": BLAST["rate21"], "S23": BLAST["rate23"]}
WHY["S21"] += f"；实测 {RATE['S21']:.3f} 倍慢镜头（约 3 倍升格）"
_tb = T_CRASH + 2 / cb.FPS + RATE["S21"] * 4 / cb.FPS                 # 起爆 = S21 第 490 帧
OFF["S23"] = _tb + BLAST["dsync23"] - (569 - 1) / cb.FPS - RATE["S23"] * (585 - 569) / cb.FPS
WHY["S23"] = f"S23 第 585 帧起爆 = S21 第 490 帧起爆（联合拟合同步误差 {BLAST['dsync23']:+.2f} s）；实测 {RATE['S23']:.3f} 倍慢镜头"
# 跳车两镜头也是慢镜头：同镜头科尔维特剪辑时间车速 / 真实车速（约 28.5 m/s）
def _cv_speed(k):
    cv = S[k]["cv"]
    a_, b_ = cv[0], cv[-1]
    return math.hypot(b_["xyyaw"][0] - a_["xyyaw"][0], b_["xyyaw"][1] - a_["xyyaw"][1]) / ((b_["frame"] - a_["frame"]) / cb.FPS)
for k in ("S19", "S20"):
    if k in S and S[k].get("cv"):
        RATE[k] = round(min(1.0, _cv_speed(k) / 28.5), 3)
        WHY[k] = WHY.get(k, "") + f"；实测 {RATE[k]:.2f} 倍慢镜头（剪辑时间车速 {_cv_speed(k):.1f} m/s）"
RATE["S16"] = RATE["S17"] = RATE.get("S19", 1.0)
RATE["S24"] = RATE["S23"]                      # v3：紧接 S23 的反打，同档慢镜头【推断】
OFF["S24"] = (569 - 1) / cb.FPS + OFF["S23"] + RATE["S23"] * (615 - 569) / cb.FPS - (615 - 1) / cb.FPS
WHY["S24"] = "v3：紧接 S23 末（身后正在爆炸），同档慢镜头【推断】"
if "S04" in S and S["S04"].get("vtr"):
    RATE["S04"] = round(min(1.0, S["S04"]["vtr"] / V), 3)
    WHY["S04"] += f"；火车相对桥头只有 {S['S04']['vtr']:.1f} m/s，按 {RATE['S04']:.2f} 倍慢镜头"
OFF["S20"] = (458 - 1) / cb.FPS + OFF["S19"] + RATE.get("S19", 1.0) * (473 - 458) / cb.FPS - (473 - 1) / cb.FPS
OFF["S17"] = (458 - 1) / cb.FPS + OFF["S19"] - RATE["S19"] / cb.FPS - (437 - 1) / cb.FPS
OFF["S16"] = OFF["S17"] + RATE["S17"] * (437 - 408) / cb.FPS - (437 - 408) / cb.FPS
WHY["S16"] = WHY["S17"] = "起跳特写，平行插入；按 S19 同档慢镜头处理【推断】（S17 第 437 帧离开车顶 ≈ S19 首帧前 1 帧）"
WHY["S20"] = WHY.get("S20", "") + "；按世界时间接 S19 末"
OFF["S22"] = (T_CRASH + 2 / cb.FPS + RATE["S21"] * (540 - 486) / cb.FPS) - (541 - 1) / cb.FPS
WHY["S22"] = "接 S21 末（S21 是慢镜头，按世界时间接续）"
# S25：科尔维特车载 POV，求解出第 638 帧车在 X≈1.9，按 S21 撞后的科尔维特轨迹（约 25 m/s）反推时刻
if "S25" in S:
    x638 = next(c["pose"][0] for c in S["S25"]["cams"] if c["frame"] == 638) - 0.3
    OFF["S25"] = (T_CRASH + 0.1 + x638 / 25.0) - (638 - 1) / cb.FPS
    WHY["S25"] = f"科尔维特车载 POV 第 638 帧 X≈{x638:.1f}，接 S21 撞后轨迹（剪辑上紧接 S24，世界里与 S21 重叠）"


def T(f):
    k = cb.shot_of(f)
    a = cb.SHOTS[k][0]
    return (a - 1) / cb.FPS + OFF[k] + RATE.get(k, 1.0) * (f - a) / cb.FPS


def truck_front(TT):
    return V * (TT - T_CRASH)


# ---------------------------------------------------------------- 科尔维特关键帧
cvk = []
for k, s in S.items():
    if s.get("cv"):
        for c in s["cv"]:
            x, y, yaw = c["xyyaw"]
            cvk.append((T(c["frame"]), x - truck_front(T(c["frame"])), y, k, c["frame"]))
    if k in ("S03", "S25") and s.get("cams"):     # 科尔维特车载相机：相机 ≈ 车身中心前 0.3 m
        for c in s["cams"]:
            cvk.append((T(c["frame"]), c["pose"][0] - 0.3 - truck_front(T(c["frame"])), c["pose"][1], k, c["frame"]))
cvk = [c for c in cvk if c[3] != "S04"]
for f in (138, 155, 171):            # S04：科尔维特在卡车驾驶室后约 143 px ≈ 0.75 节车厢
    cvk.append((T(f), -26.0, -9.0, "S04画面比例", f))
cvk.sort()

# ---------------------------------------------------------------- 特写机位（挂在车上；local 坐标 x 向车头、y 向车左、z 向上）
# pos：相机在挂载物体局部坐标；aim：对准点 (挂载物体名, 局部坐标)；依据见读点代理对各镜头的描述
DOM_HEAD = ("corvette", (-0.43, 0.38, 1.24))
BRIAN_CV_SEAT = ("corvette", (-0.43, -0.38, 1.24))
BRIAN_HEAD = ("brian", (0.0, 0.0, 0.74))      # 布莱恩头部（跟着他走：车顶 → 空中 → 科尔维特）
# 车载几何镜头：横向/高度/朝向取逐镜头求解值，纵向挂在车上（lx = 相机在车身局部 x；None = 沿用求解出的相对位置）
MOUNTED = {"S11": ("truck", None), "S13": ("truck", None),
           "S15": ("truck", (4.5, 1.2, 1.87)), "S18": ("truck", (4.5, 1.2, 1.87))}   # v3：S15/S18 在卡车驾驶室顶左前角
# 逐镜头平滑强度（位置 σ, 朝向 σ，单位帧）。原片真实的快速运动少平滑：S03 甩镜、S09 急速上摇、S25 车载颠簸
SMOOTH = {"S03": (2.0, 1.0), "S01": (0.0, 0.0), "S09": (0.0, 0.0), "S25": (1.5, 0.6)}   # S01 前两秒本身是样条路径，S09 太近
CV_X_FROM_WORLD = {}                   # S19：每帧相机 X 平移量（= 科尔维特统一世界 X − 求解 X）
CV_HOOD = {"S03": 3.3, "S25": 0.65}      # S25：仪表台上方、风挡前（v5：原先贴着风挡上框）      # v4：S03 相机离地约 0.6 m，挂在科尔维特车头前保险杠（车身中心在相机后 2.8 m）
HOOD_FROM = {"S03": 999}               # v4：S03 相机离地很低（原片钢轨几乎贴着地平线），不再强抬到 1.05 m     # 科尔维特引擎盖/驾驶舱机位：相机用求解值，车身中心 = 相机后方 lx 米（作弊量由此反推）
# 特写机位（v3 Opus 精校后）：
#   aim=…        每帧对准目标（只用于 S05/S06/S17 这类本来就跟着人的机位）
#   aim_once=…   只在镜头首帧对准一次，之后朝向相对挂载物固定（固定机位不追人）
#   orient=(yaw_rel, pitch, roll)  直接给相对挂载物航向的朝向
#   keys=[(帧, pos, orient, hfov), …]  多段机位，段间 smoothstep 插值
#   head_rel=(dx, dy, dz)  相机放在布莱恩头部（镜头首帧）的世界偏移处，换算成挂载物局部后固定
RIGS = {
    "S02": dict(mount="corvette", pos=(2.2, -2.4, 1.25), aim_once=DOM_HEAD, hfov=10),        # 右前方长焦斜看驾驶位（v3 拉近到 3.8 m）
    "S05": dict(mount="corvette", pos=(0.25, -0.22, 0.48), aim=("corvette", (0.8, 0.38, 0.15)), hfov=70),   # v5：挪到变速杆副驾侧，避开换挡的手臂
    "S06": dict(mount="corvette", pos=(0.9, 0.3, 1.25), aim_once=DOM_HEAD, hfov=45),
    "S08": dict(mount="corvette", keys=[(237, (6.0, -4.9, 0.8), (132.0, 0.0, 3.0), 30),      # v3：车头右前方回看车，再上摇到爬出驾驶室的布莱恩
                                        (239, (6.0, -4.9, 0.8), (132.0, 0.0, 3.0), 30),
                                        (249, (2.5, -3.2, 1.4), "brian", 30),          # v4：往外拉到车右前方约 4 m，对准从驾驶室爬出的布莱恩
                                        (254, (2.5, -3.2, 1.4), "brian", 30)]),
    "S10": dict(mount="truck", pos=(4.5, -4.0, 1.3), orient=(136.9, 38.2, 0.0), hfov=40),   # v3：车头保险杠右前方仰拍，固定朝向
    "S12": dict(mount="truck", head_rel=(2.0, 0.0, -0.4), orient=(180.0, 10.0, 0.0), hfov=24),   # v3：头前 2 m、略低，近正脸
    "S14": dict(mount="truck", head_rel=(2.0, 0.0, -0.4), orient=(180.0, 10.0, 0.0), hfov=24),
    "S16": dict(mount="truck", head_rel=(2.9, 0.0, -0.7), orient=(180.0, 14.0, 0.0), hfov=16),
    "S17": dict(mount="corvette", pos=(-0.8, -1.0, 1.0), aim=BRIAN_HEAD, hfov=42),
    "S22": dict(mount="corvette", pos=(-1.0, -1.25, 0.95), orient=(20.0, 13.0, 0.0), hfov=45),   # v3：布莱恩右后方车外，朝前偏左看桥
    "S24": dict(mount="corvette", pos=(0.30, -0.23, 1.00), orient=(180.0, 26.0, 0.0), hfov=68),  # v3：风挡处朝后，防滚架横管在画面下缘
}


# v5：S01 前两秒的飞行机位（卡车局部坐标；位置 + 注视目标 + 滚转），对着原片逐段理顺：
#   1–13 帧在卡车右前方低处回头看、推近驾驶室；16–19 贴着前轮掠过、转向车斗；22–34 贴着白车斗板上方往车尾飞
#   （画面上方是车厢破口里的火）；37–46 在车尾升起、带滚转转身朝前；49 帧接回求解机位。
#   车斗板面在局部 z ≈ -0.75 + 0.18·(x+1.6)（后端低），相机保持在板面上方 ≥0.35 m；车厢壁在局部 y ≈ 0.6 - 0.16x 以外，相机 y ≤ -0.8
S01_PATH = [  # (帧, 相机局部, 目标局部, 滚转)；第 1、3 帧由求解机位换算（见 s01_opening_cam）
    (7, (16.0, -5.0, -0.3), (3.0, 0.0, 0.5), -1.0),
    (13, (9.0, -4.6, 0.0), (2.5, 0.0, 0.3), 0.0),
    (16, (5.5, -4.3, 0.2), (0.5, 0.3, 0.0), 0.0),
    (19, (2.0, -3.4, 0.3), (-3.0, 0.5, -0.5), 0.0),
    (22, (0.5, -2.2, 0.0), (-4.0, 1.5, 0.3), 0.0),
    (25, (-0.8, -1.4, -0.2), (-3.5, 2.0, 0.2), 0.0),
    (28, (-2.0, -1.0, -0.4), (-4.5, 2.2, 0.0), 0.0),
    (31, (-3.0, -0.9, -0.5), (-5.5, 2.0, -0.1), 0.0),
    (34, (-4.0, -0.9, -0.55), (-6.0, 2.0, 0.0), -2.0),
    (37, (-5.2, -1.2, 0.3), (-3.0, 3.0, 1.5), -8.0),
    (40, (-6.5, -2.0, 1.2), (0.0, 3.0, 1.5), -15.0),
    (43, (-8.5, -3.6, 1.2), (20.0, 1.5, 0.5), -17.0),
    (46, (-9.5, -5.5, 0.5), (30.0, 1.0, 0.0), -17.0),
]


S01_SOLVED = []


def s01_opening_cam(f, ks_world, interp):
    """S01 第 f 帧（f<49）的世界相机 (x,y,z,yaw,pitch,roll)：局部关键帧样条插值，加 49 帧求解机位作末端"""
    import world as wd_
    keys = [(fr, [*p, *t, r]) for fr, p, t, r in S01_PATH]
    def solved_to_local(fr, pw, roll=None):
        cx, cy, cz, yaw_, pu = wd_.truck_embed(T(fr))
        R = wd_._truck_R(yaw_, pu)
        def to_local(Pw):
            d = [Pw[i] - (cx, cy, cz)[i] for i in range(3)]
            return [sum(R[j][i] * d[j] for j in range(3)) for i in range(3)]
        yw, pt = math.radians(pw[3]), math.radians(pw[4])
        tgt = [pw[0] + 30 * math.cos(pt) * math.cos(yw), pw[1] + 30 * math.cos(pt) * math.sin(yw), pw[2] + 30 * math.sin(pt)]
        return (fr, [*to_local(pw[:3]), *to_local(tgt), pw[5] if roll is None else roll])
    # 第 1、3 帧：第 3 帧求解机位（唯一有几何读点的开场帧）；第 49 帧：接回后段求解机位
    k3 = next(p_ for f_, p_ in S01_SOLVED if f_ == 3)
    keys += [solved_to_local(1, k3), solved_to_local(3, k3), solved_to_local(49, interp(ks_world, 49), -17.0)]
    keys.sort()
    v = interp(keys, f)
    P = wd_.truck_local(T(f), v[0:3])
    Q = wd_.truck_local(T(f), v[3:6])
    d = [q - p_ for q, p_ in zip(Q, P)]
    return [*P, math.degrees(math.atan2(d[1], d[0])), math.degrees(math.atan2(d[2], math.hypot(d[0], d[1]))), v[6]]


def geo_ok(shot, f):
    """v5：这一帧有没有足够的几何读点来定相机（≥2 个非人物点）。只有人物读点的关键帧，相机实际没解出来，不参与插值。"""
    import picks_io
    import human as hm_
    if shot in STATIC:
        return True
    human = set(hm_.NAMES) | {"brian", "brian_head", "brian_pelvis", "dom_head"}
    for kf in picks_io.merged(shot):
        if kf["frame"] == f:
            return sum(1 for p in kf["picks"] if p["name"] not in human) >= 2
    return True


STATIC = {"S07", "S21", "S23"}


def curated_cv():
    """科尔维特关键帧 [T, dx, y, 依据]。dx = 车身中心 - 卡车车头 X（卡车撞停后，参考点仍按车速前进）。"""
    a = lambda k, f: T(f) if k is None else (cb.SHOTS[k][0] - 1) / cb.FPS + OFF[k] + RATE.get(k, 1) * (f - cb.SHOTS[k][0]) / cb.FPS
    absx = lambda TT, x: x - truck_front(TT)
    k = [
        [a("S07", 234), -9.5, -6.5, "S07 末：车头追到卡车尾"],
        [a("S08", 250), -2.0, -6.0, "S08：与驾驶室并排"],
        [a("S09", 285), 3.0, -7.5, "S09 末：已追到卡车车头前"],
        [a("S13", 361), 3.0, -7.1, "S13 实测：车尾在后轮旁相机前 8–9 m → 车身中心约在车头前 3 m"],
        [a("S19", 458), 3.0, -6.8, "S19 跳车：在被切开的车门下"],
    ]
    c1, c2 = BLAST["cv21"], BLAST["cv23"]                  # 两机位联合拟合的科尔维特匀速段，取平均
    x0, y0 = (c1[0] + c2[0]) / 2, (c1[1] + c2[1]) / 2
    vx, vy = (c1[2] + c2[2]) / 2, (c1[3] + c2[3]) / 2
    for dt in (-0.15, 0.9):
        TT = T_CRASH + dt
        k.append([TT, absx(TT, x0 + vx * dt), max(-9.0, min(-4.6, y0 + vy * dt)), f"S21+S23 联合拟合：撞击时刻 ({x0:.1f},{y0:.1f})、速度 {math.hypot(vx, vy):.1f} m/s"])
    k.sort()
    return k


def main():
    # ------------------------------------------------ 科尔维特：相对卡车车头的轨迹，同一主时间附近的读数取平均
    keys = []
    for TT, dx, y, k, f in cvk:
        if keys and TT - keys[-1][0] < 0.15:
            n = keys[-1][4] + 1
            keys[-1] = [(keys[-1][0] * (n - 1) + TT) / n, (keys[-1][1] * (n - 1) + dx) / n, (keys[-1][2] * (n - 1) + y) / n, keys[-1][3] + [f"{k}:{f}"], n]
        else:
            keys.append([TT, dx, y, [f"{k}:{f}"], 1])
    print("科尔维特关键帧（主时间 T、相对卡车车头 dx、横向 y、来源）")
    for TT, dx, y, src, _ in keys:
        print(f"  T={TT:6.2f}  dx={dx:7.1f}  y={y:6.1f}   {','.join(src)}")
    print("（以上为逐镜头求解原始读数，仅作诊断；世界里用下面按剧情节点整理的关键帧）")
    cur = curated_cv()
    for TT, dx, y, why in cur:
        print(f"  ★ T={TT:6.2f}  dx={dx:7.1f}  y={y:5.1f}   {why}")
    wp = json.load(open("data/world_params.json"))
    wp.update({
        "v_train": V, "t_crash": T_CRASH, "truck_to_front": TRUCK_TO_FRONT, "truck_y": TRUCK_Y,
"cv_keys": [[round(TT, 3), round(dx, 2), y] for TT, dx, y, _ in cur],
        "cv_keys_why": [w for *_, w in cur],
        "rate": RATE,
        "offset": {k: round(v, 3) for k, v in OFF.items()},
        "offset_why": WHY,
    })
    wp.setdefault("crash_pitch", 35.0); wp.setdefault("crash_lift", 0.25); wp.setdefault("blast_dt", 0.25)
    wp.setdefault("blast_v", [3.0, -4.0, 7.0]); wp.setdefault("blast_spin", 160.0)
    # 跳车：落车时刻取 S19 实测（第 468.5 帧）；起跳按物理给 0.75 s（从 4.1 m 落到 0.95 m、离开车顶竖直速度约 +1.6 m/s）。
    # 剪辑里两镜头对上的世界时长只有约 0.18 s，与自由落体不符（疑似威亚/合成），画面里看到的是逐帧拟合的姿态
    wp["jump"] = [round(T(468.5) - 0.75, 3), round(T(468.5), 3)]
    wp["brian_on_cab"] = EMBED["brian_on_cab"]   # v4：开场站在驾驶室顶的笼架上（卡车局部坐标，随卡车偏转/抬头）
    wp["embed_yaw"], wp["embed_pitch"] = EMBED["yaw"], EMBED["pitch"]
    wp["brian_shot_local"] = BRIAN_SHOT_LOCAL
    wp["brian_to_cage"] = 17.3                    # v4：S01 整段他都在驾驶室上，换到车斗笼架要等 S01 结束之后
    wp["tear"] = EMBED["tear"]
    wp["brian_on_truck"] = [2.0, -1.2, 2.3]       # S11 骨盆读点反推：趴在卡车右侧边缘笼架上，骨盆在车载相机前约 4.5 m、离地 4.1 m
    j1 = wp["jump"][1]
    wp["brian_cv_keys"] = [[j1, -1.5, 0.1, 0.95], [j1 + 0.6, -1.0, -0.2, 0.95], [T_CRASH + 0.1, -0.45, -0.38, 0.55]]   # 尾部甲板趴 → 爬进副驾
    json.dump(wp, open("data/world_params.json", "w"), ensure_ascii=False, indent=1)

    # ------------------------------------------------ 逐镜头作弊量：该镜头实测科尔维特位置 − 统一世界里的位置（首末关键帧，镜头内线性）
    import importlib
    import world as wd
    importlib.reload(wd)
    def obj_frame0(name, TT):
        if name == "corvette":
            x, y, yaw = wd.corvette(TT)
            return (x, y, 0.0), yaw
        x, y, z, _ = wd.truck(TT)
        return (x, y, z - cb.TRUCK_H / 2), 0.0
    def lerp_pose(ks, f):
        """关键帧位姿插值：三次 Catmull-Rom 样条（v5：比折线插值顺，关键帧处没有速度突变）；两端外推保持"""
        if f <= ks[0][0]:
            return list(ks[0][1])
        if f >= ks[-1][0]:
            return list(ks[-1][1])
        i = max(j for j in range(len(ks)) if ks[j][0] <= f)
        if i >= len(ks) - 1:
            return list(ks[-1][1])
        f1, p1 = ks[i]; f2, p2 = ks[i + 1]
        f0, p0 = ks[i - 1] if i > 0 else (f1 - (f2 - f1), [2 * a - b for a, b in zip(p1, p2)])
        f3, p3 = ks[i + 2] if i + 2 < len(ks) else (f2 + (f2 - f1), [2 * b - a for a, b in zip(p1, p2)])
        t = (f - f1) / (f2 - f1)
        out = []
        for a, b, c, d in zip(p0, p1, p2, p3):
            m1 = (c - a) / (f2 - f0) * (f2 - f1)       # 非均匀间隔的切线
            m2 = (d - b) / (f3 - f1) * (f2 - f1)
            t2, t3 = t * t, t * t * t
            out.append((2 * t3 - 3 * t2 + 1) * b + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * c + (t3 - t2) * m2)
        return out
    cheat = {}
    for k, lx in CV_HOOD.items():
        if k in S:
            rows = []
            for c in (S[k]["cams"][0], S[k]["cams"][-1]):
                x, y, z, yaw = c["pose"][:4]
                wx, wy, _ = wd.corvette(T(c["frame"]))
                a_ = math.radians(yaw)
                rows.append([c["frame"], round(x - lx * math.cos(a_) - wx, 2), round(y - lx * math.sin(a_) - wy, 2)])
            cheat[k] = rows
    pk = {s_["shot"]: s_ for s_ in json.load(open("data/picks.json"))["shots"]}
    for k, s_ in S.items():
        if not s_.get("cv") or k in CV_HOOD:
            continue
        fr = [kf["frame"] for kf in pk[k]["keys"] if any(p["name"].startswith("cv_") for p in kf["picks"])] or [c["frame"] for c in s_["cv"]]
        if k in ("S21", "S23", "S07"):                   # v2 重读镜头：用求解里全部科尔维特帧的首末
            fr = [c["frame"] for c in s_["cv"]]
        ks = [c for c in s_["cv"] if c["frame"] in (fr[0], fr[-1])]
        rows = []
        for c in ks:
            wx, wy, _ = wd.corvette(T(c["frame"]))
            dcx = dcy = 0.0
            if k in MOUNTED:                      # 车载相机被挂到世界卡车上，物体跟着相机的位移一起挪
                cam = next(q["pose"] for q in s_["cams"] if q["frame"] == c["frame"])
                (tx, ty, _), _ = obj_frame0(MOUNTED[k][0], T(c["frame"]))
                fm = s_["cams"][len(s_["cams"]) // 2]
                (mx, _, _), _ = obj_frame0(MOUNTED[k][0], T(fm["frame"]))
                lx_ = fm["pose"][0] - mx
                dcx, dcy = (tx + lx_) - cam[0], 0.0
            rows.append([c["frame"], round(c["xyyaw"][0] + dcx - wx, 2), round(c["xyyaw"][1] + dcy - wy, 2)])
        cheat[k] = rows
    wp["cv_cheat"] = cheat
    # 有逐帧求解的镜头：科尔维特位姿（含航向）直接用实测轨迹
    track = {}
    for k, s_ in S.items():
        if s_.get("cv") and k not in CV_HOOD and k not in MOUNTED:
            track[k] = [[c["frame"], *[round(v, 3) for v in c["xyyaw"]]] for c in s_["cv"]]
    # 卡车车载镜头：相机被挂到世界卡车上会整体平移，科尔维特跟着平移同样的量（保持和相机的相对关系）
    for k in MOUNTED:
        s_ = S.get(k)
        if not s_ or not s_.get("cv") or isinstance(MOUNTED[k][1], tuple):
            continue
        ks_ = [(c["frame"], list(c["pose"])) for c in s_["cams"]]
        fm = ks_[len(ks_) // 2][0]
        (mx, _, _), _ = obj_frame0("truck", T(fm))
        lx_ = lerp_pose(ks_, fm)[0] - mx
        rows = []
        for c in s_["cv"]:
            f_ = c["frame"]
            (tx, ty, tz), _ = obj_frame0("truck", T(f_))
            cam_s = lerp_pose(ks_, f_)
            rows.append([f_, round(c["xyyaw"][0] + (tx + lx_ - cam_s[0]), 3), round(c["xyyaw"][1], 3), round(c["xyyaw"][2], 3)])
        track[k] = rows
    # v3：S19 没有静止参照，纵向深度测不准 → 科尔维特 X 跟统一世界（卡车车头前 2.9 m），相机跟着平移同样的量
    CV_X_FROM_WORLD.clear()
    if "S19" in track:
        for row in track["S19"]:
            wx = truck_front(T(row[0])) + 2.9
            CV_X_FROM_WORLD[row[0]] = wx - row[1]
            row[1] = round(wx, 3)
    wp["cv_track"] = track
    wp["truck_cheat"] = {"S23": -7.0}      # v3：S23 起爆前卡车不能挡在画面左半（原片左半是客车侧面和科尔维特）
    json.dump(wp, open("data/world_params.json", "w"), ensure_ascii=False, indent=1)
    importlib.reload(wd)
    print("科尔维特逐镜头作弊量（米，首/末关键帧 dx, dy）：")
    for k, rows in sorted(cheat.items()):
        print(f"  {k}: " + "  ".join(f"f{f} ({dx:+.1f}, {dy:+.1f})" for f, dx, dy in rows))

    # ------------------------------------------------ 相机：每帧世界位姿
    cams = {}
    def obj_frame(name, TT, f=None):
        if name == "brian":
            return (wd.brian_f(f) if f else wd.brian(TT)), 0.0
        if name == "corvette":
            x, y, yaw = wd.corvette_f(f) if f else wd.corvette(TT)
            return (x, y, 0.0), yaw
        x, y, z, _ = wd.truck(TT)
        return (x, y, z - cb.TRUCK_H / 2), 0.0
    def to_world(name, TT, l, f=None):
        (ox, oy, oz), yaw = obj_frame(name, TT, f)
        a = math.radians(yaw)
        return ox + l[0] * math.cos(a) - l[1] * math.sin(a), oy + l[0] * math.sin(a) + l[1] * math.cos(a), oz + l[2]
    for shot, (a, b) in cb.SHOTS.items():
        rows = []
        if shot in RIGS:
            r = RIGS[shot]
            mount = r["mount"]
            def heading(f_):
                return obj_frame(mount, T(f_), f_)[1]
            def world_pose(f_, pos, orient):
                yw = heading(f_) + orient[0]
                return [*to_world(mount, T(f_), pos, f_), yw, orient[1], orient[2]]
            fixed = None
            if "aim_once" in r or "head_rel" in r:          # 首帧定一次：位置/朝向换成挂载物局部，之后跟车走
                (ox, oy, oz), oyaw = obj_frame(mount, T(a), a)
                ca, sa = math.cos(math.radians(oyaw)), math.sin(math.radians(oyaw))
                if "head_rel" in r:
                    hx, hy, hz = to_world("brian", T(a), (0.0, 0.0, 0.74), a)
                    Pw = (hx + r["head_rel"][0], hy + r["head_rel"][1], hz + r["head_rel"][2])
                    orient = r["orient"]
                    yw0 = orient[0]                        # head_rel 的朝向是世界朝向
                    orient = (yw0 - oyaw, orient[1], orient[2])
                else:
                    Pw = to_world(mount, T(a), r["pos"], a)
                    Q = to_world(r["aim_once"][0], T(a), r["aim_once"][1], a)
                    d = [q - p_ for q, p_ in zip(Q, Pw)]
                    orient = (math.degrees(math.atan2(d[1], d[0])) - oyaw, math.degrees(math.atan2(d[2], math.hypot(d[0], d[1]))), 0.0)
                lp = ((Pw[0] - ox) * ca + (Pw[1] - oy) * sa, -(Pw[0] - ox) * sa + (Pw[1] - oy) * ca, Pw[2] - oz)
                fixed = (lp, orient)
            for f in range(a, b + 1):
                TT = T(f)
                if fixed:
                    rows.append([f, *world_pose(f, fixed[0], fixed[1]), r["hfov"]])
                elif "keys" in r:
                    ks_ = r["keys"]
                    k0 = max((k for k in ks_ if k[0] <= f), key=lambda k: k[0], default=ks_[0])
                    k1 = min((k for k in ks_ if k[0] >= f), key=lambda k: k[0], default=ks_[-1])
                    t_ = 0.0 if k1[0] == k0[0] else (f - k0[0]) / (k1[0] - k0[0])
                    t_ = t_ * t_ * (3 - 2 * t_)              # smoothstep
                    pos = tuple(u + (v - u) * t_ for u, v in zip(k0[1], k1[1]))
                    def _ori(k_):
                        if k_[2] != "brian":
                            return k_[2]
                        P_ = to_world(mount, T(f), k_[1], f)
                        Q_ = to_world("brian", T(f), (0.0, 0.0, 0.74), f)
                        d_ = [q - p_ for q, p_ in zip(Q_, P_)]
                        return (math.degrees(math.atan2(d_[1], d_[0])) - heading(f), math.degrees(math.atan2(d_[2], math.hypot(d_[0], d_[1]))), 0.0)
                    o0, o1 = _ori(k0), _ori(k1)
                    ori = tuple(u + (v - u) * t_ for u, v in zip(o0, o1))
                    rows.append([f, *world_pose(f, pos, ori), k0[3] + (k1[3] - k0[3]) * t_])
                elif "orient" in r:
                    rows.append([f, *world_pose(f, r["pos"], r["orient"]), r["hfov"]])
                else:
                    P = to_world(mount, TT, r["pos"], f)
                    Q = to_world(r["aim"][0], TT, r["aim"][1], f)
                    d = [q - p_ for q, p_ in zip(Q, P)]
                    rows.append([f, *P, math.degrees(math.atan2(d[1], d[0])), math.degrees(math.atan2(d[2], math.hypot(d[0], d[1]))), 0.0, r["hfov"]])
            cams[shot] = {"mount": "world", "src": "rig", "keys": rows}
        elif shot in S and shot in MOUNTED:
            s = S[shot]
            mount, lx = MOUNTED[shot]
            ks = [(c["frame"], list(c["pose"])) for c in s["cams"]]
            for f in range(a, b + 1):
                x, y, z, yaw, pitch, roll = lerp_pose(ks, f)
                TT = T(f)
                (ox, oy, oz), oyaw = obj_frame(mount, TT)
                if isinstance(lx, tuple):                 # 固定挂点（局部 x, y, z）
                    P = to_world(mount, TT, lx)
                else:
                    if lx is None:                        # 沿用求解出的纵向相对位置（按关键帧中点）
                        fm = ks[len(ks) // 2][0]
                        (mx, _, _), _ = obj_frame(mount, T(fm))
                        lx_ = lerp_pose(ks, fm)[0] - mx
                    else:
                        lx_ = lx
                    P = to_world(mount, TT, (lx_, y - oy, z - oz))
                rows.append([f, *P, yaw, pitch, roll, s["hfov"]])
            cams[shot] = {"mount": "world", "src": f"挂{mount} 求解中位{s['median_px']:.1f}px", "keys": rows}
        elif shot in S:
            s = S[shot]
            ks = [(c["frame"], list(c["pose"])) for c in s["cams"] if geo_ok(shot, c["frame"])]
            if shot == "S01":
                S01_SOLVED[:] = ks
                ks = [k for k in ks if k[0] >= 49] or ks
                s01_track = True
            else:
                s01_track = False
            for i in range(1, len(ks)):                  # 偏航解缠绕
                while ks[i][1][3] - ks[i - 1][1][3] > 180: ks[i][1][3] -= 360
                while ks[i][1][3] - ks[i - 1][1][3] < -180: ks[i][1][3] += 360
            shiftx = sorted(CV_X_FROM_WORLD.items()) if shot == "S19" else []
            for f in range(a, b + 1):
                if s01_track and f < 49:
                    rows.append([f, *s01_opening_cam(f, ks, lerp_pose), s["hfov"]])
                    continue
                pose = lerp_pose(ks, f)
                if shiftx:
                    pose[0] += lerp_pose([(ff, [d]) for ff, d in shiftx], f)[0]
                if shot in CV_HOOD and f >= HOOD_FROM.get(shot, a):
                    pose[2] = max(pose[2], 1.05)
                rows.append([f, *pose, s["hfov"]])
            cams[shot] = {"mount": "world", "src": f"solve 中位{s['median_px']:.1f}px", "keys": rows}
    # v5：运动镜头的逐帧相机在镜头内做高斯平滑（默认位置 σ=3 帧、朝向 σ=2 帧；逐帧都有关键帧的跟拍镜头，平滑越足越贴读点），去掉逐关键帧求解的噪声抖动；
    # 固定机位不变，真实的快速甩镜（S03）在 σ=2 帧下保留
    import numpy as np_
    def _gauss(arr, sig):
        if sig <= 0 or len(arr) < 3:
            return arr
        r_ = int(3 * sig)
        k_ = np_.exp(-0.5 * (np_.arange(-r_, r_ + 1) / sig) ** 2); k_ /= k_.sum()
        pad = np_.pad(arr, ((r_, r_), (0, 0)), mode="reflect", reflect_type="odd")   # 按直线外推补齐，匀速运动两端不被拉弯
        return np_.stack([np_.convolve(pad[:, j], k_, mode="valid") for j in range(arr.shape[1])], 1)
    for shot, c in cams.items():
        rows_ = np_.array([r[1:7] for r in c["keys"]], float)
        if len(rows_) < 5 or np_.ptp(rows_, 0).max() < 1e-6:
            continue
        rows_[:, 0:3] = _gauss(rows_[:, 0:3], SMOOTH.get(shot, (3.0, 2.0))[0])
        rows_[:, 3:6] = _gauss(rows_[:, 3:6], SMOOTH.get(shot, (3.0, 2.0))[1])
        for r, v in zip(c["keys"], rows_):
            r[1:7] = [float(x) for x in v]
    for c in cams.values():                       # v5：所有相机离地 ≥ 0.15 m（近裁剪不会切进地面）
        for r in c["keys"]:
            r[3] = max(r[3], 0.15)
    json.dump(cams, open("data/cams.json", "w"))
    print("偏移：", {k: round(v, 2) for k, v in sorted(OFF.items())})
    print("相机：", {k: c["src"] for k, c in sorted(cams.items())})
    miss = [k for k in cb.SHOTS if k not in cams]
    if miss:
        print("缺相机：", miss)


if __name__ == "__main__":
    main()
