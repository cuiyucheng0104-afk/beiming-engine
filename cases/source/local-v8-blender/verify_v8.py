import bpy, json, math
from mathutils import Vector
L = 14.0
S = bpy.context.scene
objs = bpy.data.objects
rows = []
worst = {"big": 0.0, "small": 0.0, "axis_dir": 0.0}
for f in (1, 7, 13, 19, 25, 31, 37, 43, 55, 71):
    S.frame_set(f)
    bpy.context.view_layer.update()
    for bank in "LR":
        for i in range(4):
            tag = f"{bank}{i+1}"
            rod, pist, pin = objs[f"Rod_{tag}"], objs[f"Piston_{tag}"], objs[f"Crank_pin{i+1}"]
            M = rod.matrix_world
            big = M @ Vector((0, 0, -L / 2))
            small = M @ Vector((0, 0, L / 2))
            pinw = pin.matrix_world.translation
            wrist = pist.matrix_world @ Vector((0, 0, -0.4))
            e_big = math.hypot(big.x - pinw.x, big.z - pinw.z)
            e_small = (small - wrist).length
            worst["big"] = max(worst["big"], e_big)
            worst["small"] = max(worst["small"], e_small)
            along = (pist.matrix_world.to_quaternion() @ Vector((0, 0, 1)))
            exp = Vector((-math.sqrt(.5) if bank == "L" else math.sqrt(.5), 0, math.sqrt(.5)))
            worst["axis_dir"] = max(worst["axis_dir"], (along - exp).length)
tdc = max((objs["Piston_L1"].matrix_world.translation.length), 0)
S.frame_set(1)
print("RESULT", json.dumps({k: round(v, 6) for k, v in worst.items()}))
# piston travel over the loop for one cylinder
ts = []
for f in range(1, 73):
    S.frame_set(f); bpy.context.view_layer.update()
    ts.append(objs["Piston_L1"].matrix_world.translation.length)
print("TRAVEL", round(min(ts), 3), round(max(ts), 3), "stroke", round(max(ts) - min(ts), 3), "expected", 2 * 4.2)
