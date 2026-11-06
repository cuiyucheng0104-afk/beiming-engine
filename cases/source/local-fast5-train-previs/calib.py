"""全部常量的唯一来源（纯 Python，Blender 内外都能 import）。
时间：参考片 24fps、646 帧；镜头表在 data/shots.json；世界坐标约定见 data/CONVENTIONS.md。"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
FPS, FRAMES = 24, 646
RES = (1280, 544)                               # 读点坐标系；原片 3840×1632，宽高比 2.353
SENSOR_W = 36.0                                 # Blender 相机传感器宽（mm），焦距按水平视场换算
SHOTS = {k: tuple(v) for k, v in json.load(open(os.path.join(HERE, "data/shots.json"))).items()}


def shot_of(f):
    for k, (a, b) in SHOTS.items():
        if a <= f <= b:
            return k
    raise ValueError(f)


# ---------------------------------------------------------------- 物体尺寸（米）
CV_LEN, CV_W, CV_WB, CV_H = 4.45, 1.77, 2.49, 1.25        # 1963 科尔维特 C2 Grand Sport
CAR_LEN, CAR_W, CAR_H, CAR_GAP = 26.0, 3.2, 4.0, 1.0       # 客车车厢（长度待测）
N_CARS = 9
TRUCK_LEN, TRUCK_W, TRUCK_H = 9.0, 2.6, 3.6                # 改装卡车（待测）
RAIL_GAUGE = 1.435

# ---------------------------------------------------------------- 场景布局
BRIDGE_LEN = 240.0              # 桥长（向 +X）
TRUSS_Y = 2.9                   # 两片桁架中心离轨道中心
TRUSS_PANEL = 8.0               # 节间长
TRUSS_H_END, TRUSS_H_MID = 9.0, 13.0   # 曲弦桁架：端部 / 跨中高度
CANYON_DEPTH = 90.0             # 约 300 英尺
RIM_ANGLE_DEG = 18.0            # 右侧崖边与轨道的夹角（崖边从桥头附近向 −X、−Y 斜退）
RIM_X0 = 60.0                   # 右侧崖边与轨道右侧路基线的交点 X（桥旁还有一段地面）
