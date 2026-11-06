import bpy, math, os, json, sys
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
N = 144
PERIOD = 72
R_CRANK = 4.2
L_ROD = 14.0
SY = 11.0
THROW_ANGLE = [0.0, 90.0, 270.0, 180.0]
THROW_Y = [(i - 1.5) * SY for i in range(4)]
ROD_OFF = {"L": 1.3, "R": -1.3}
S45 = math.sqrt(0.5)
BANK_DIR = {"L": Vector((-S45, 0, S45)), "R": Vector((S45, 0, S45))}
BORE_R = 4.4
PISTON_H = 5.2
PIN_BIAS = 0.4

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.frame_start = 1
scene.frame_end = N
scene.render.fps = 24
try:
    bpy.context.preferences.edit.keyframe_new_interpolation_type = "LINEAR"
except Exception:
    pass


def material(name, rgb, metallic=0.0, rough=0.5, alpha=1.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    node = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    node.inputs["Base Color"].default_value = (*rgb, 1)
    node.inputs["Metallic"].default_value = metallic
    node.inputs["Roughness"].default_value = rough
    if alpha < 1.0:
        node.inputs["Alpha"].default_value = alpha
        try:
            m.surface_render_method = "BLENDED"
        except Exception:
            pass
    return m


M = {
    "steel": material("steel", (0.62, 0.64, 0.68), 1.0, 0.28),
    "crank": material("crank", (0.30, 0.31, 0.34), 1.0, 0.22),
    "alu": material("alu", (0.70, 0.72, 0.76), 1.0, 0.42),
    "piston": material("piston", (0.86, 0.84, 0.78), 1.0, 0.30),
    "rod": material("rod", (0.45, 0.46, 0.50), 1.0, 0.30),
    "glass": material("glass", (0.55, 0.75, 1.0), 0.0, 0.05, 0.22),
    "case": material("case", (0.55, 0.75, 1.0), 0.0, 0.05, 0.07),
    "red": material("red", (0.62, 0.05, 0.04), 0.1, 0.35),
    "black": material("black", (0.025, 0.025, 0.03), 0.4, 0.5),
    "floor": material("floor", (0.085, 0.09, 0.10), 0.0, 0.6),
}


def basis_z(z_axis):
    z = Vector(z_axis).normalized()
    y = Vector((0, 1, 0))
    x = y.cross(z).normalized()
    return Matrix(((x.x, y.x, z.x), (x.y, y.y, z.y), (x.z, y.z, z.z)))


RX90 = Matrix.Rotation(math.pi / 2, 3, "X")


def place(o, name, loc, rot, mat, parent=None):
    o.name = name
    o.rotation_mode = "QUATERNION"
    o.rotation_quaternion = (rot or Matrix.Identity(3)).to_quaternion()
    o.location = loc
    if parent is not None:
        o.parent = parent
    o.data.materials.append(M[mat])
    for p in o.data.polygons:
        p.use_smooth = True
    return o


def cyl(name, r, depth, loc, rot, mat, parent=None, verts=40):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=depth)
    return place(bpy.context.active_object, name, loc, rot, mat, parent)


def box(name, dims, loc, rot, mat, parent=None):
    bpy.ops.mesh.primitive_cube_add(size=1)
    o = bpy.context.active_object
    o.scale = dims
    bpy.ops.object.transform_apply(scale=True)
    place(o, name, loc, rot, mat, parent)
    for p in o.data.polygons:
        p.use_smooth = False
    return o


crank = bpy.data.objects.new("Crank", None)
bpy.context.collection.objects.link(crank)
crank.rotation_mode = "XYZ"

half_len = 1.5 * SY + 9
cyl("Crank_shaft", 2.3, 2 * half_len, (0, 0, 0), RX90, "crank", crank)
cyl("Crank_nose", 3.0, 3.0, (0, -half_len - 1.5, 0), RX90, "steel", crank)
cyl("Flywheel", 10.0, 2.6, (0, half_len + 1.4, 0), RX90, "steel", crank, 64)
cyl("Flywheel_hub", 4.0, 3.2, (0, half_len + 1.4, 0), RX90, "crank", crank)
for k in range(24):
    a = 2 * math.pi * k / 24
    cyl(f"Flywheel_bolt{k}", 0.35, 3.0, (8.2 * math.sin(a), half_len + 1.4, 8.2 * math.cos(a)), RX90, "black", crank, 12)

pin_objs = {}
for i, (y, th) in enumerate(zip(THROW_Y, THROW_ANGLE)):
    t = math.radians(th)
    pos = (R_CRANK * math.sin(t), y, R_CRANK * math.cos(t))
    pin_objs[i] = cyl(f"Crank_pin{i + 1}", 2.0, 5.6, pos, RX90, "crank", crank)
    for side, dy in (("a", -3.4), ("b", 3.4)):
        away = (-math.sin(t), 0, -math.cos(t))
        cyl(f"Web{i + 1}{side}_pin", 3.0, 1.6, (pos[0], y + dy, pos[2]), RX90, "crank", crank)
        cw = (away[0] * 3.6, y + dy, away[2] * 3.6)
        cyl(f"Web{i + 1}{side}_weight", 4.6, 1.6, cw, RX90, "crank", crank)
        mid = ((pos[0] + cw[0]) / 2, y + dy, (pos[2] + cw[2]) / 2)
        ax = Vector((pos[0] - cw[0], 0, pos[2] - cw[2]))
        box(f"Web{i + 1}{side}_bar", (5.4, 1.6, ax.length), mid, basis_z(ax), "crank", crank)

rods, pistons, wrist = {}, {}, {}
for bank in ("L", "R"):
    d = BANK_DIR[bank]
    rot_bank = basis_z(d)
    for i, y in enumerate(THROW_Y):
        yy = y + ROD_OFF[bank]
        tag = f"{bank}{i + 1}"
        rod = cyl(f"Rod_{tag}", 0.95, L_ROD, (0, yy, 0), None, "rod")
        cyl(f"Rod_{tag}_big", 2.7, 2.2, (0, 0, -L_ROD / 2), RX90, "rod", rod)
        cyl(f"Rod_{tag}_small", 1.7, 2.2, (0, 0, L_ROD / 2), RX90, "rod", rod)
        rods[tag] = rod
        pist = cyl(f"Piston_{tag}", 4.3, PISTON_H, (0, yy, 0), rot_bank, "piston")
        for g in range(3):
            cyl(f"Piston_{tag}_ring{g}", 4.36, 0.28, (0, 0, PISTON_H / 2 - 0.7 - g * 0.65), None, "black", pist, 40)
        pistons[tag] = pist
        barrel = cyl(f"Barrel_{tag}", 5.15, 14.0, d * 15.0 + Vector((0, yy, 0)), rot_bank, "glass")
        cyl(f"Barrel_{tag}_flange", 5.7, 0.9, d * 8.4 + Vector((0, yy, 0)), rot_bank, "alu")

for bank in ("L", "R"):
    d = BANK_DIR[bank]
    rot_bank = basis_z(d)
    box(f"Head_{bank}", (12.0, 4 * SY + 1.0, 4.4), d * 24.2, rot_bank, "alu")
    box(f"ValveCover_{bank}", (9.0, 4 * SY - 3.0, 2.8), d * 27.8, rot_bank, "red")
    for i, y in enumerate(THROW_Y):
        yy = y + ROD_OFF[bank]
        box(f"Coil_{bank}{i + 1}", (2.2, 2.2, 3.2), d * 30.8 + Vector((0, yy, 0)), rot_bank, "black")

box("Crankcase", (21.0, 4 * SY + 6.0, 13.5), (0, 0, -2.5), None, "case")
box("Crankcase_frame", (21.4, 4 * SY + 6.4, 0.9), (0, 0, 4.2), None, "alu")
box("Oil_pan", (17.0, 4 * SY + 4.0, 4.5), (0, 0, -11.2), None, "black")
bpy.ops.mesh.primitive_plane_add(size=4000, location=(0, 0, -14.0))
floor = bpy.context.active_object
floor.name = "Floor"
floor.data.materials.append(M["floor"])

target = bpy.data.objects.new("CamTarget", None)
target.location = (0, 0, 6)
bpy.context.collection.objects.link(target)
cam_data = bpy.data.cameras.new("Cam")
cam_data.lens = 38
cam = bpy.data.objects.new("Camera", cam_data)
rig = bpy.data.objects.new("CamRig", None)
bpy.context.collection.objects.link(rig)
bpy.context.collection.objects.link(cam)
cam.parent = rig
cam.location = (0, -106, 50)
con = cam.constraints.new("TRACK_TO")
con.target = target
con.track_axis = "TRACK_NEGATIVE_Z"
con.up_axis = "UP_Y"
scene.camera = cam
rig.rotation_mode = "XYZ"
for f in (1, N + 1):
    rig.rotation_euler = (0, 0, math.radians(-38) + 2 * math.pi * (f - 1) / N)
    rig.keyframe_insert("rotation_euler", frame=f)

sun = bpy.data.lights.new("Sun", "SUN")
sun.energy = 2.2
sun_o = bpy.data.objects.new("Sun", sun)
sun_o.rotation_euler = (math.radians(48), math.radians(8), math.radians(35))
bpy.context.collection.objects.link(sun_o)
area = bpy.data.lights.new("Fill", "AREA")
area.energy = 4500
area.size = 70
area_o = bpy.data.objects.new("Fill", area)
area_o.location = (-50, -60, 85)
area_o.rotation_euler = (math.radians(35), 0, math.radians(-35))
bpy.context.collection.objects.link(area_o)
for nm, loc, rot, en, sz in (("Rim", (70, 60, 50), (math.radians(60), 0, math.radians(140)), 5000, 60), ("Top", (0, -20, 120), (0, 0, 0), 6000, 90), ("Side", (-90, -40, 30), (math.radians(80), 0, math.radians(-70)), 4000, 50)):
    ld = bpy.data.lights.new(nm, "AREA"); ld.energy = en; ld.size = sz
    lo = bpy.data.objects.new(nm, ld); lo.location = loc; lo.rotation_euler = rot
    bpy.context.collection.objects.link(lo)

world = bpy.data.worlds.new("World")
world.use_nodes = True
bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
bg.inputs["Color"].default_value = (0.075, 0.08, 0.09, 1)
bg.inputs["Strength"].default_value = 1.0
scene.world = world

enum = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
scene.render.engine = "BLENDER_EEVEE" if "BLENDER_EEVEE" in enum else ("BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in enum else "CYCLES")
scene.render.resolution_x = 1280
scene.render.resolution_y = 720
scene.render.image_settings.file_format = "PNG"
try:
    scene.eevee.taa_render_samples = 48
except Exception:
    pass


def kinematics(alpha, bank, yy):
    c = Vector((R_CRANK * math.sin(alpha), 0, R_CRANK * math.cos(alpha)))
    d = BANK_DIR[bank]
    dc = d.dot(c)
    t = dc + math.sqrt(dc * dc - c.length_squared + L_ROD * L_ROD)
    w = d * t
    return c + Vector((0, yy, 0)), w + Vector((0, yy, 0)), d


for f in range(1, N + 1):
    phi = 2 * math.pi * (f - 1) / PERIOD
    crank.rotation_euler = (0, phi, 0)
    crank.keyframe_insert("rotation_euler", frame=f)
    for bank in ("L", "R"):
        for i, y in enumerate(THROW_Y):
            tag = f"{bank}{i + 1}"
            yy = y + ROD_OFF[bank]
            alpha = math.radians(THROW_ANGLE[i]) + phi
            c, w, d = kinematics(alpha, bank, yy)
            rod = rods[tag]
            rod.location = (c + w) / 2
            rod.rotation_quaternion = basis_z(w - c).to_quaternion()
            rod.keyframe_insert("location", frame=f)
            rod.keyframe_insert("rotation_quaternion", frame=f)
            p = pistons[tag]
            p.location = w + d * PIN_BIAS
            p.keyframe_insert("location", frame=f)

scene.frame_set(1)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, "v8_engine.blend"))
print("OBJECTS", len(bpy.data.objects), "ENGINE", scene.render.engine)
